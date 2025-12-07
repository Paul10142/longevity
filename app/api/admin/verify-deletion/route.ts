import { NextRequest, NextResponse } from "next/server"
import { supabaseAdmin } from "@/lib/supabaseServer"

export async function GET(request: NextRequest) {
  try {
    if (!supabaseAdmin) {
      return NextResponse.json(
        { error: "Supabase not configured" },
        { status: 500 }
      )
    }

    const { searchParams } = new URL(request.url)
    const conceptSlug = searchParams.get('concept') || 'male-fertility'

    // Find the concept by slug
    const { data: concept, error: conceptError } = await supabaseAdmin
      .from('concepts')
      .select('id, name, slug')
      .eq('slug', conceptSlug)
      .single()

    if (conceptError || !concept) {
      return NextResponse.json({
        error: `Concept "${conceptSlug}" not found`,
        conceptError: conceptError?.message
      }, { status: 404 })
    }

    // Get all insights linked to this concept (including deleted ones for verification)
    const { data: insightsData, error: insightsError } = await supabaseAdmin
      .from('insight_concepts')
      .select(
        `
        insights (
          id,
          statement,
          deleted_at,
          created_at,
          insight_sources (
            source_id,
            sources (
              id,
              title
            )
          )
        )
      `
      )
      .eq('concept_id', concept.id)

    if (insightsError) {
      return NextResponse.json({
        error: `Error fetching insights: ${insightsError.message}`
      }, { status: 500 })
    }

    const allInsights = (insightsData || []).map((item: any) => item.insights).filter((i: any) => i?.id)
    const activeInsights = allInsights.filter((i: any) => !i.deleted_at)
    const deletedInsights = allInsights.filter((i: any) => i.deleted_at)

    // Get source information for active insights
    const sourceIds = new Set<string>()
    activeInsights.forEach((insight: any) => {
      const sources = insight.insight_sources || []
      sources.forEach((link: any) => {
        if (link.sources?.id) {
          sourceIds.add(link.sources.id)
        }
      })
    })

    // Get processing runs for these sources to see which runs might have been deleted
    const sourceIdsArray = Array.from(sourceIds)
    let runsInfo: any[] = []
    if (sourceIdsArray.length > 0) {
      const { data: runsData } = await supabaseAdmin
        .from('source_processing_runs')
        .select('id, source_id, processed_at, status, total_insights_created')
        .in('source_id', sourceIdsArray)
        .order('processed_at', { ascending: false })

      runsInfo = runsData || []
    }

    return NextResponse.json({
      concept: {
        id: concept.id,
        name: concept.name,
        slug: concept.slug
      },
      insights: {
        total: allInsights.length,
        active: activeInsights.length,
        deleted: deletedInsights.length
      },
      activeInsights: activeInsights.map((insight: any) => ({
        id: insight.id,
        statement: insight.statement.substring(0, 100) + (insight.statement.length > 100 ? '...' : ''),
        sources: (insight.insight_sources || []).map((link: any) => ({
          id: link.sources?.id,
          title: link.sources?.title
        })).filter((s: any) => s.id)
      })),
      deletedInsights: deletedInsights.map((insight: any) => ({
        id: insight.id,
        statement: insight.statement.substring(0, 100) + (insight.statement.length > 100 ? '...' : ''),
        deletedAt: insight.deleted_at
      })),
      processingRuns: runsInfo.map((run: any) => ({
        id: run.id,
        sourceId: run.source_id,
        processedAt: run.processed_at,
        status: run.status,
        totalInsightsCreated: run.total_insights_created
      })),
      sources: Array.from(sourceIds).length
    })
  } catch (error) {
    console.error("Error in GET /api/admin/verify-deletion:", error)
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Unknown error" },
      { status: 500 }
    )
  }
}

