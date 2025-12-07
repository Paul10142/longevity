import { NextRequest, NextResponse } from "next/server"
import { supabaseAdmin } from "@/lib/supabaseServer"
import { generateInsightEmbedding, generateConceptEmbedding } from "@/lib/embeddings"

/**
 * Background job to generate embeddings for all existing insights and concepts
 * Processes in batches to avoid rate limits
 * 
 * POST /api/admin/insights/generate-embeddings
 * Body: { batchSize?: number, startFrom?: number, type?: 'insights' | 'concepts' | 'both' }
 */
export async function POST(request: NextRequest) {
  try {
    if (!supabaseAdmin) {
      return NextResponse.json(
        { error: "Supabase not configured. Please set up environment variables." },
        { status: 500 }
      )
    }

    const body = await request.json().catch(() => ({}))
    const batchSize = body.batchSize || 50 // Process 50 at a time
    const startFrom = body.startFrom || 0
    const type = body.type || 'both' // 'insights', 'concepts', or 'both'

    const results = {
      insights: { processed: 0, errors: 0, total: 0 },
      concepts: { processed: 0, errors: 0, total: 0 },
    }

    // Generate embeddings for insights
    if (type === 'insights' || type === 'both') {
      // Count total insights without embeddings
      const { count: totalCount } = await supabaseAdmin
        .from('insights')
        .select('*', { count: 'exact', head: true })
        .is('embedding', null)
        .is('deleted_at', null)

      results.insights.total = totalCount || 0

      // Fetch batch of insights without embeddings
      const { data: insights, error: insightsError } = await supabaseAdmin
        .from('insights')
        .select('id, statement, context_note')
        .is('embedding', null)
        .is('deleted_at', null)
        .range(startFrom, startFrom + batchSize - 1)

      if (insightsError) {
        console.error('Error fetching insights:', insightsError)
        return NextResponse.json(
          { error: `Error fetching insights: ${insightsError.message}` },
          { status: 500 }
        )
      }

      // Process each insight
      for (const insight of insights || []) {
        try {
          const embedding = await generateInsightEmbedding(insight)
          
          const { error: updateError } = await supabaseAdmin
            .from('insights')
            .update({ embedding })
            .eq('id', insight.id)

          if (updateError) {
            console.error(`Error updating insight ${insight.id}:`, updateError)
            results.insights.errors++
          } else {
            results.insights.processed++
            console.log(`[Embeddings] Generated embedding for insight ${insight.id} (${results.insights.processed}/${results.insights.total})`)
          }

          // Small delay to avoid rate limits
          await new Promise(resolve => setTimeout(resolve, 100))
        } catch (error) {
          console.error(`Error generating embedding for insight ${insight.id}:`, error)
          results.insights.errors++
        }
      }
    }

    // Generate embeddings for concepts
    if (type === 'concepts' || type === 'both') {
      // Count total concepts without embeddings
      const { count: totalCount } = await supabaseAdmin
        .from('concepts')
        .select('*', { count: 'exact', head: true })
        .is('embedding', null)

      results.concepts.total = totalCount || 0

      // Fetch batch of concepts without embeddings
      const { data: concepts, error: conceptsError } = await supabaseAdmin
        .from('concepts')
        .select('id, name, description')
        .is('embedding', null)
        .range(startFrom, startFrom + batchSize - 1)

      if (conceptsError) {
        console.error('Error fetching concepts:', conceptsError)
        return NextResponse.json(
          { error: `Error fetching concepts: ${conceptsError.message}` },
          { status: 500 }
        )
      }

      // Process each concept
      for (const concept of concepts || []) {
        try {
          const embedding = await generateConceptEmbedding(concept)
          
          const { error: updateError } = await supabaseAdmin
            .from('concepts')
            .update({ embedding })
            .eq('id', concept.id)

          if (updateError) {
            console.error(`Error updating concept ${concept.id}:`, updateError)
            results.concepts.errors++
          } else {
            results.concepts.processed++
            console.log(`[Embeddings] Generated embedding for concept ${concept.id} (${results.concepts.processed}/${results.concepts.total})`)
          }

          // Small delay to avoid rate limits
          await new Promise(resolve => setTimeout(resolve, 100))
        } catch (error) {
          console.error(`Error generating embedding for concept ${concept.id}:`, error)
          results.concepts.errors++
        }
      }
    }

    return NextResponse.json({
      success: true,
      message: `Processed ${results.insights.processed} insights and ${results.concepts.processed} concepts`,
      results,
      nextBatch: {
        startFrom: startFrom + batchSize,
        hasMore: (type === 'insights' || type === 'both') && results.insights.processed < results.insights.total ||
                 (type === 'concepts' || type === 'both') && results.concepts.processed < results.concepts.total
      }
    })
  } catch (error) {
    console.error("Error in POST /api/admin/insights/generate-embeddings:", error)
    return NextResponse.json(
      { 
        error: error instanceof Error ? error.message : "Unknown error",
        details: error instanceof Error ? error.stack : undefined
      },
      { status: 500 }
    )
  }
}

