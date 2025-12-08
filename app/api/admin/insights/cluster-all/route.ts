/**
 * Cluster All Insights API Route
 * 
 * POST /api/admin/insights/cluster-all
 * 
 * 1. First generates missing embeddings for all insights
 * 2. Then triggers clustering on all existing unclustered insights
 * Processes in batches to avoid timeouts
 * 
 * Supports Server-Sent Events (SSE) for progress updates
 */

import { NextRequest, NextResponse } from 'next/server'
import { buildMergeClustersForNewInsights } from '@/lib/clustering'
import { supabaseAdmin } from '@/lib/supabaseServer'
import { generateInsightEmbedding } from '@/lib/embeddings'

// Helper to send SSE data (silently fails if client disconnected)
function sendSSE(controller: ReadableStreamDefaultController, data: any) {
  try {
    const message = `data: ${JSON.stringify(data)}\n\n`
    controller.enqueue(new TextEncoder().encode(message))
  } catch (error) {
    // Client disconnected - processing continues but we can't send updates
    console.log('Client disconnected, continuing processing in background')
  }
}

export async function POST(request: NextRequest) {
  try {
    if (!supabaseAdmin) {
      return NextResponse.json(
        { error: 'Supabase not configured' },
        { status: 500 }
      )
    }

    // Check if client wants streaming progress updates
    const acceptHeader = request.headers.get("accept") || ""
    const wantsStreaming = acceptHeader.includes("text/event-stream")

    const body = await request.json().catch(() => ({}))
    const batchSize = body.batchSize || 500
    const maxBatches = body.maxBatches || 10 // Process up to 10 batches (5000 insights)
    const skipEmbeddings = body.skipEmbeddings || false // Option to skip embedding generation

    const results = {
      embeddings: { processed: 0, errors: 0, total: 0 },
      clustering: { processed: 0, clustersCreated: 0, membersAdded: 0, mergeIntoUniqueSuggestions: 0, errors: 0, batchesProcessed: 0, total: 0 }
    }

    // If streaming requested, return SSE response
    if (wantsStreaming) {
      const stream = new ReadableStream({
        async start(controller) {
          try {
            await processClusterAll(controller, results, batchSize, maxBatches, skipEmbeddings)
            
            // Send final completion message
            sendSSE(controller, {
              done: true,
              result: results,
              message: `Generated ${results.embeddings.processed} embeddings, processed ${results.clustering.processed} insights, created ${results.clustering.clustersCreated} clusters, ${results.clustering.mergeIntoUniqueSuggestions} merge-into-unique suggestions`
            })
            
            controller.close()
          } catch (error) {
            console.error('[Cluster All] Stream error:', error)
            sendSSE(controller, {
              error: error instanceof Error ? error.message : 'Unknown error',
              done: true
            })
            controller.close()
          }
        }
      })

      return new Response(stream, {
        headers: {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          'Connection': 'keep-alive',
        },
      })
    }

    // Non-streaming fallback (for backwards compatibility)
    await processClusterAll(null, results, batchSize, maxBatches, skipEmbeddings)

    return NextResponse.json({
      success: true,
      message: `Generated ${results.embeddings.processed} embeddings, processed ${results.clustering.processed} insights, created ${results.clustering.clustersCreated} clusters, ${results.clustering.mergeIntoUniqueSuggestions} merge-into-unique suggestions`,
      result: results
    })
  } catch (error) {
    console.error('Error in cluster-all API:', error)
    return NextResponse.json(
      {
        error: error instanceof Error ? error.message : 'Unknown error',
        details: error instanceof Error ? error.stack : undefined
      },
      { status: 500 }
    )
  }
}

async function processClusterAll(
  controller: ReadableStreamDefaultController | null,
  results: any,
  batchSize: number,
  maxBatches: number,
  skipEmbeddings: boolean
) {
  // Create job record
  const { data: jobRecord, error: jobError } = await supabaseAdmin
    .from('cluster_jobs')
    .insert({
      status: 'processing',
      embeddings_total: 0,
      embeddings_processed: 0,
      embeddings_errors: 0,
      clustering_total: 0,
      clustering_processed: 0,
      clusters_created: 0,
      members_added: 0,
      merge_into_unique_suggestions: 0,
      clustering_errors: 0,
      batches_processed: 0
    })
    .select('id')
    .single()

  const jobId = jobRecord?.id

  if (jobError) {
    console.error('Error creating cluster job record:', jobError)
  }

  const updateJobProgress = async () => {
    if (jobId) {
      await supabaseAdmin
        .from('cluster_jobs')
        .update({
          embeddings_total: results.embeddings.total,
          embeddings_processed: results.embeddings.processed,
          embeddings_errors: results.embeddings.errors,
          clustering_total: results.clustering.total,
          clustering_processed: results.clustering.processed,
          clusters_created: results.clustering.clustersCreated,
          members_added: results.clustering.membersAdded,
          merge_into_unique_suggestions: results.clustering.mergeIntoUniqueSuggestions,
          clustering_errors: results.clustering.errors,
          batches_processed: results.clustering.batchesProcessed
        })
        .eq('id', jobId)
    }
  }

  const completeJob = async (finalStatus: 'completed' | 'failed', errorMessage?: string) => {
    if (jobId) {
      await supabaseAdmin
        .from('cluster_jobs')
        .update({
          status: finalStatus,
          completed_at: new Date().toISOString(),
          error_message: errorMessage || null,
          embeddings_total: results.embeddings.total,
          embeddings_processed: results.embeddings.processed,
          embeddings_errors: results.embeddings.errors,
          clustering_total: results.clustering.total,
          clustering_processed: results.clustering.processed,
          clusters_created: results.clustering.clustersCreated,
          members_added: results.clustering.membersAdded,
          merge_into_unique_suggestions: results.clustering.mergeIntoUniqueSuggestions,
          clustering_errors: results.clustering.errors,
          batches_processed: results.clustering.batchesProcessed
        })
        .eq('id', jobId)
    }
  }

  try {
    // Step 1: Generate missing embeddings first (unless skipped)
  if (!skipEmbeddings) {
    console.log('[Cluster All] Step 1: Generating missing embeddings...')
    
    // Count total insights without embeddings
    const { count: totalWithoutEmbeddings } = await supabaseAdmin
      .from('insights')
      .select('*', { count: 'exact', head: true })
      .is('embedding', null)
      .is('deleted_at', null)

    results.embeddings.total = totalWithoutEmbeddings || 0
    console.log(`[Cluster All] Found ${results.embeddings.total} insights without embeddings`)

    if (controller) {
      sendSSE(controller, {
        stage: 'embeddings',
        total: results.embeddings.total,
        processed: 0,
        errors: 0
      })
    }

    if (results.embeddings.total > 0) {
      let processed = 0
      const embeddingBatchSize = 50 // Smaller batches for embeddings to avoid rate limits

      while (processed < results.embeddings.total) {
        // Fetch batch of insights without embeddings (always query fresh to handle interruptions)
        const { data: insights, error: fetchError } = await supabaseAdmin
          .from('insights')
          .select('id, statement, context_note')
          .is('embedding', null)
          .is('deleted_at', null)
          .limit(embeddingBatchSize)

        if (fetchError) {
          console.error('Error fetching insights for embedding:', fetchError)
          results.embeddings.errors += embeddingBatchSize
          if (controller) {
            sendSSE(controller, {
              stage: 'embeddings',
              error: 'Error fetching insights',
              processed: results.embeddings.processed,
              total: results.embeddings.total,
              errors: results.embeddings.errors
            })
          }
          break
        }

        if (!insights || insights.length === 0) {
          break
        }

        // Generate embeddings for this batch
        for (const insight of insights) {
          try {
            const embedding = await generateInsightEmbedding(insight)
            
            const { error: updateError } = await supabaseAdmin
              .from('insights')
              .update({ embedding })
              .eq('id', insight.id)

            if (updateError) {
              console.error(`Error updating insight ${insight.id}:`, updateError)
              results.embeddings.errors++
            } else {
              results.embeddings.processed++
            }

            // Send progress update every 10 embeddings or at the end of batch
            if (results.embeddings.processed % 10 === 0 || insights.indexOf(insight) === insights.length - 1) {
              if (controller) {
                sendSSE(controller, {
                  stage: 'embeddings',
                  processed: results.embeddings.processed,
                  total: results.embeddings.total,
                  errors: results.embeddings.errors
                })
              }
              console.log(`[Cluster All] Generated ${results.embeddings.processed}/${results.embeddings.total} embeddings...`)
            }

            // Small delay to avoid rate limits
            await new Promise(resolve => setTimeout(resolve, 100))
          } catch (error) {
            console.error(`Error generating embedding for insight ${insight.id}:`, error)
            results.embeddings.errors++
            if (controller) {
              sendSSE(controller, {
                stage: 'embeddings',
                processed: results.embeddings.processed,
                total: results.embeddings.total,
                errors: results.embeddings.errors
              })
            }
          }
        }

        processed += insights.length

        // Small delay between batches
        if (processed < results.embeddings.total) {
          await new Promise(resolve => setTimeout(resolve, 500))
        }
      }

      console.log(`[Cluster All] Step 1 complete: Generated ${results.embeddings.processed} embeddings (${results.embeddings.errors} errors)`)
      if (controller) {
        sendSSE(controller, {
          stage: 'embeddings',
          complete: true,
          processed: results.embeddings.processed,
          total: results.embeddings.total,
          errors: results.embeddings.errors
        })
      }
    } else {
      if (controller) {
        sendSSE(controller, {
          stage: 'embeddings',
          complete: true,
          processed: 0,
          total: 0,
          errors: 0,
          message: 'All insights already have embeddings'
        })
      }
    }
  } else {
    console.log('[Cluster All] Skipping embedding generation (skipEmbeddings=true)')
    if (controller) {
      sendSSE(controller, {
        stage: 'embeddings',
        skipped: true
      })
    }
  }

  // Step 2: Cluster insights
  console.log('[Cluster All] Step 2: Starting clustering for all unclustered insights...')

  // Count total insights to cluster (for progress tracking)
  const { count: totalToCluster } = await supabaseAdmin
    .from('insights')
    .select('*', { count: 'exact', head: true })
    .is('unique_insight_id', null)
    .is('deleted_at', null)
    .not('embedding', 'is', null) // Only count insights with embeddings

  results.clustering.total = totalToCluster || 0

  if (controller) {
    sendSSE(controller, {
      stage: 'clustering',
      total: results.clustering.total,
      processed: 0,
      clustersCreated: 0,
      membersAdded: 0,
      mergeIntoUniqueSuggestions: 0,
      errors: 0,
      batchesProcessed: 0
    })
  }

  // Process in batches
  while (results.clustering.batchesProcessed < maxBatches) {
    const result = await buildMergeClustersForNewInsights({
      limit: batchSize
    })

    results.clustering.processed += result.processed
    results.clustering.clustersCreated += result.clustersCreated
    results.clustering.membersAdded += result.membersAdded
    results.clustering.mergeIntoUniqueSuggestions += result.mergeIntoUniqueSuggestions
    results.clustering.errors += result.errors
    results.clustering.batchesProcessed++

    console.log(`[Cluster All] Clustering batch ${results.clustering.batchesProcessed}:`, result)

    // Send progress update
    await updateJobProgress()
    if (controller) {
      sendSSE(controller, {
        stage: 'clustering',
        processed: results.clustering.processed,
        total: results.clustering.total,
        clustersCreated: results.clustering.clustersCreated,
        membersAdded: results.clustering.membersAdded,
        mergeIntoUniqueSuggestions: results.clustering.mergeIntoUniqueSuggestions,
        errors: results.clustering.errors,
        batchesProcessed: results.clustering.batchesProcessed
      })
    }

    // If no insights were processed, we're done
    if (result.processed === 0) {
      break
    }

    // Small delay between batches to avoid overwhelming the system
    if (results.clustering.batchesProcessed < maxBatches) {
      await new Promise(resolve => setTimeout(resolve, 1000))
    }
  }

  console.log('[Cluster All] Complete:', results)

  await completeJob('completed')

  if (controller) {
    sendSSE(controller, {
      stage: 'clustering',
      complete: true,
      processed: results.clustering.processed,
      total: results.clustering.total,
      clustersCreated: results.clustering.clustersCreated,
      membersAdded: results.clustering.membersAdded,
      mergeIntoUniqueSuggestions: results.clustering.mergeIntoUniqueSuggestions,
      errors: results.clustering.errors,
      batchesProcessed: results.clustering.batchesProcessed
    })
  }
  } catch (error) {
    console.error('[Cluster All] Error:', error)
    await completeJob('failed', error instanceof Error ? error.message : 'Unknown error')
    throw error
  }
}
