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

    // First, try to fetch insights with needs_tagging = true (newly created)
    const { data: needsTaggingInsights, error: fetchError1 } = await supabaseAdmin
      .from('insights')
      .select('id, statement, context_note, evidence_type, confidence, qualifiers, insight_type, importance, actionability, primary_audience')
      .eq('needs_tagging', true)
      .is('deleted_at', null)
      .limit(requestedLimit)

    if (fetchError1) {
      console.error('[autotag-batch] Error fetching insights:', fetchError1)
      return NextResponse.json(
        { error: `Failed to fetch insights: ${fetchError1.message}` },
        { status: 500 }
      )
    }

    let insights = needsTaggingInsights || []

    // If we don't have enough insights with needs_tagging, also fetch untagged insights
    // (for retroactive tagging of existing sources)
    if (insights.length < requestedLimit) {
      // Get all insight IDs that already have tags
      const { data: taggedInsights, error: taggedError } = await supabaseAdmin
        .from('insight_concepts')
        .select('insight_id')
      
      if (taggedError) {
        console.warn('[autotag-batch] Error fetching tagged insights (non-fatal):', taggedError)
      }

      const taggedInsightIds = new Set(taggedInsights?.map((ti: any) => ti.insight_id) || [])
      const existingIds = new Set(insights.map((i: any) => i.id))
      
      // Fetch additional insights that don't have tags yet
      const { data: allInsights, error: fetchError2 } = await supabaseAdmin
        .from('insights')
        .select('id, statement, context_note, evidence_type, confidence, qualifiers, insight_type, importance, actionability, primary_audience')
        .is('deleted_at', null)
        .limit(requestedLimit * 3) // Fetch more to account for filtering
      
      if (!fetchError2 && allInsights) {
        // Filter to only untagged insights that we haven't already included
        const untaggedInsights = allInsights.filter((i: any) => 
          !taggedInsightIds.has(i.id) && !existingIds.has(i.id)
        ).slice(0, requestedLimit - insights.length)
        
        if (untaggedInsights.length > 0) {
          insights = [...insights, ...untaggedInsights]
          console.log(`[autotag-batch] Added ${untaggedInsights.length} untagged insights for retroactive tagging`)
        }
      }
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
    const insightsWithIds = insights.map((insightRow: any) => ({
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
