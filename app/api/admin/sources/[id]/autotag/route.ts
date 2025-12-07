import { NextRequest, NextResponse } from "next/server"
import { supabaseAdmin } from "@/lib/supabaseServer"
import { autoTagInsightsBatch, getConceptsCached } from "@/lib/autotag"
import type { Insight } from "@/lib/pipeline"

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    if (!supabaseAdmin) {
      return NextResponse.json(
        { error: "Supabase not configured. Please set up environment variables." },
        { status: 500 }
      )
    }

    const { id: sourceId } = await params

    console.log(`[autotag-source] Starting auto-tagging for source ${sourceId}`)

    // Fetch all insights linked to this source
    const { data: insightSources, error: fetchError } = await supabaseAdmin
      .from('insight_sources')
      .select(`
        insight_id,
        insights (
          id,
          statement,
          context_note,
          evidence_type,
          confidence,
          qualifiers,
          insight_type,
          importance,
          actionability,
          primary_audience,
          deleted_at
        )
      `)
      .eq('source_id', sourceId)

    if (fetchError) {
      console.error('[autotag-source] Error fetching insights:', fetchError)
      return NextResponse.json(
        { error: `Failed to fetch insights: ${fetchError.message}` },
        { status: 500 }
      )
    }

    if (!insightSources || insightSources.length === 0) {
      return NextResponse.json({
        success: true,
        processed: 0,
        tagged: 0,
        skipped: 0,
        errors: 0,
        message: 'No insights found for this source'
      })
    }

    // Filter out deleted insights and get unique insights
    const uniqueInsights = new Map<string, any>()
    insightSources.forEach((is: any) => {
      const insight = is.insights
      if (insight && !insight.deleted_at && !uniqueInsights.has(insight.id)) {
        uniqueInsights.set(insight.id, insight)
      }
    })

    const insightsArray = Array.from(uniqueInsights.values())

    if (insightsArray.length === 0) {
      return NextResponse.json({
        success: true,
        processed: 0,
        tagged: 0,
        skipped: 0,
        errors: 0,
        message: 'No valid insights found for this source'
      })
    }

    // Get concepts (cached)
    let concepts
    try {
      concepts = await getConceptsCached()
    } catch (conceptsError) {
      console.error('[autotag-source] Error fetching concepts:', conceptsError)
      return NextResponse.json(
        { error: `Failed to fetch concepts: ${conceptsError instanceof Error ? conceptsError.message : 'Unknown error'}` },
        { status: 500 }
      )
    }

    // Build insight objects for batch processing
    const insightsWithIds = insightsArray.map((insightRow: any) => ({
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

    let processed = 0
    let tagged = 0
    let skipped = 0
    let errors = 0

    // Process results
    for (const insightRow of insightsArray) {
      try {
        const conceptIds = tagResults.get(insightRow.id) || []

        if (conceptIds.length === 0) {
          // No concepts matched - mark as processed if it had needs_tagging
          if (insightRow.needs_tagging) {
            const { error: updateError } = await supabaseAdmin
              .from('insights')
              .update({ needs_tagging: false })
              .eq('id', insightRow.id)

            if (updateError) {
              console.error(`[autotag-source] Error updating insight ${insightRow.id}:`, updateError)
              errors++
            } else {
              skipped++
            }
          } else {
            skipped++
          }
          processed++
          continue
        }

        // Insert concept links (ignore duplicates)
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
            console.error(`[autotag-source] Error inserting links for insight ${insightRow.id}:`, insertError)
            errors++
            processed++
            continue
          }
        }

        // Mark as processed if it had needs_tagging
        if (insightRow.needs_tagging) {
          const { error: updateError } = await supabaseAdmin
            .from('insights')
            .update({ needs_tagging: false })
            .eq('id', insightRow.id)

          if (updateError) {
            console.error(`[autotag-source] Error updating insight ${insightRow.id}:`, updateError)
            errors++
          } else {
            tagged++
          }
        } else {
          tagged++
        }
        processed++
      } catch (error) {
        console.error(`[autotag-source] Error processing insight ${insightRow.id}:`, error)
        errors++
        processed++
      }
    }

    console.log(`[autotag-source] Finished batch for source ${sourceId}`, { processed, tagged, errors })

    return NextResponse.json({
      success: true,
      processed,
      tagged,
      skipped,
      errors
    })
  } catch (error) {
    console.error('[autotag-source] Unexpected error:', error)
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Unknown error" },
      { status: 500 }
    )
  }
}

