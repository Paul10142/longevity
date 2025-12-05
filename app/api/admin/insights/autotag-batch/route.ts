import { NextRequest, NextResponse } from "next/server"
import { supabaseAdmin } from "@/lib/supabaseServer"
import { autoTagInsightToConcepts, autoTagInsightsBatch, getConceptsCached } from "@/lib/autotag"
import type { Insight } from "@/lib/pipeline"

export async function POST(request: NextRequest) {
  try {
    if (!supabaseAdmin) {
      return NextResponse.json(
        { error: "Supabase not configured. Please set up environment variables." },
        { status: 500 }
      )
    }

    // Parse request body for optional limit
    let body: { limit?: number } = {}
    try {
      body = await request.json()
    } catch {
      // Empty body is fine, use defaults
    }
    const requestedLimit = Math.min(Math.max(1, body.limit || 50), 200) // Default 50, cap at 200

    console.log('[autotag-batch] Starting batch', { limit: requestedLimit })

    // Fetch insights that need tagging
    const { data: insights, error: fetchError } = await supabaseAdmin
      .from('insights')
      .select('id, statement, context_note, evidence_type, confidence, qualifiers, insight_type, importance, actionability, primary_audience')
      .eq('needs_tagging', true)
      .limit(requestedLimit)

    if (fetchError) {
      console.error('[autotag-batch] Error fetching insights:', fetchError)
      return NextResponse.json(
        { error: `Failed to fetch insights: ${fetchError.message}` },
        { status: 500 }
      )
    }

    if (!insights || insights.length === 0) {
      return NextResponse.json({
        success: true,
        requestedLimit,
        processed: 0,
        tagged: 0,
        skipped: 0,
        errors: 0
      })
    }

    // Get concepts (cached)
    let concepts
    try {
      concepts = await getConceptsCached()
    } catch (conceptsError) {
      console.error('[autotag-batch] Error fetching concepts:', conceptsError)
      return NextResponse.json(
        { error: `Failed to fetch concepts: ${conceptsError instanceof Error ? conceptsError.message : 'Unknown error'}` },
        { status: 500 }
      )
    }

    let processed = 0
    let tagged = 0
    let skipped = 0
    let errors = 0

    // Build insight objects for batch processing
    const insightsWithIds = insights.map(insightRow => ({
      id: insightRow.id,
      insight: {
        statement: insightRow.statement,
        context_note: insightRow.context_note,
        evidence_type: insightRow.evidence_type as Insight['evidence_type'],
        qualifiers: insightRow.qualifiers as Insight['qualifiers'],
        confidence: insightRow.confidence as Insight['confidence'],
        importance: insightRow.importance as Insight['importance'],
        actionability: insightRow.actionability as Insight['actionability'],
        primary_audience: insightRow.primary_audience as Insight['primary_audience'],
        insight_type: insightRow.insight_type as Insight['insight_type'],
      } as Insight
    }))

    // Use optimized batch processing (8 insights per API call)
    const tagResults = await autoTagInsightsBatch(insightsWithIds, concepts, 8)

    // Process results
    for (const insightRow of insights) {
      try {
        const conceptIds = tagResults.get(insightRow.id) || []

        if (conceptIds.length === 0) {
          // No concepts matched - mark as processed
          const { error: updateError } = await supabaseAdmin
            .from('insights')
            .update({ needs_tagging: false })
            .eq('id', insightRow.id)

          if (updateError) {
            console.error(`[autotag-batch] Error updating insight ${insightRow.id}:`, updateError)
            errors++
          } else {
            skipped++
          }
          processed++
          continue
        }

        // Insert concept links
        const linksToInsert = conceptIds.map(conceptId => ({
          concept_id: conceptId,
          insight_id: insightRow.id,
        }))

        const { error: insertError } = await supabaseAdmin
          .from('insight_concepts')
          .insert(linksToInsert)

        if (insertError) {
          // Might be duplicates, which is okay
          if (!insertError.message.includes('duplicate') && !insertError.message.includes('unique')) {
            console.error(`[autotag-batch] Error inserting links for insight ${insightRow.id}:`, insertError)
            errors++
            // Keep needs_tagging = true so it can be retried
            processed++
            continue
          }
        }

        // Mark as processed
        const { error: updateError } = await supabaseAdmin
          .from('insights')
          .update({ needs_tagging: false })
          .eq('id', insightRow.id)

        if (updateError) {
          console.error(`[autotag-batch] Error updating insight ${insightRow.id}:`, updateError)
          errors++
        } else {
          tagged++
        }
        processed++
      } catch (error) {
        console.error(`[autotag-batch] Error processing insight ${insightRow.id}:`, error)
        errors++
        // Keep needs_tagging = true so it can be retried later
        processed++
      }
    }

    console.log('[autotag-batch] Finished batch', { processed, tagged, errors })

    return NextResponse.json({
      success: true,
      requestedLimit,
      processed,
      tagged,
      skipped,
      errors
    })
  } catch (error) {
    console.error('[autotag-batch] Unexpected error:', error)
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Unknown error" },
      { status: 500 }
    )
  }
}
