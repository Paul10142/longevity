import { NextRequest, NextResponse } from "next/server"
import { supabaseAdmin } from "@/lib/supabaseServer"
import { autoTagAndLinkInsight } from "@/lib/autotag"
import type { Insight } from "@/lib/pipeline"

export async function POST(request: NextRequest) {
  try {
    if (!supabaseAdmin) {
      return NextResponse.json(
        { error: "Supabase not configured. Please set up environment variables." },
        { status: 500 }
      )
    }

    const body = await request.json()
    const { limit = 100, dryRun = false } = body

    // Fetch all insights (we'll filter out those with tags)
    const { data: allInsights, error: allError } = await supabaseAdmin
      .from('insights')
      .select(`
        id,
        statement,
        context_note,
        evidence_type,
        qualifiers,
        confidence,
        importance,
        actionability,
        insight_type,
      `)
      .limit(limit * 2) // Fetch more to account for filtering

    if (allError) {
      throw new Error(`Failed to fetch insights: ${allError.message}`)
    }

    // Get all linked insight IDs
    const { data: linkedInsights } = await supabaseAdmin
      .from('insight_concepts')
      .select('insight_id')

    const linkedIds = new Set(linkedInsights?.map((li: any) => li.insight_id) || [])
    
    const insightsToTag = allInsights?.filter((i: any) => !linkedIds.has(i.id)).slice(0, limit) || []

    if (dryRun) {
      return NextResponse.json({
        success: true,
        dryRun: true,
        count: insightsToTag.length,
        insights: insightsToTag.map((i: any) => ({ id: i.id, statement: i.statement }))
      })
    }

    let tagged = 0
    let errors = 0

    for (const insight of insightsToTag) {
      try {
        await autoTagAndLinkInsight(insight.id, insight as Insight)
        tagged++
      } catch (error) {
        console.error(`Error tagging insight ${insight.id}:`, error)
        errors++
      }
    }

    return NextResponse.json({
      success: true,
      tagged,
      errors,
      total: insightsToTag.length
    })
  } catch (error) {
    console.error("Error in POST /api/admin/autotag-insights:", error)
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Unknown error" },
      { status: 500 }
    )
  }
}
