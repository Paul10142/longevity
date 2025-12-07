import { NextRequest, NextResponse } from "next/server"
import { supabaseAdmin } from "@/lib/supabaseServer"

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    if (!supabaseAdmin) {
      return NextResponse.json(
        { error: "Supabase not configured" },
        { status: 500 }
      )
    }

    const { id } = await params

    // Get the run to check if it exists and get source_id
    const { data: run, error: fetchError } = await supabaseAdmin
      .from('source_processing_runs')
      .select('id, source_id, processed_at, status')
      .eq('id', id)
      .single()

    if (fetchError || !run) {
      return NextResponse.json(
        { error: "Processing run not found" },
        { status: 404 }
      )
    }

    // Delete chunks and insights associated with this specific run only
    // Get insight IDs that were linked via this run before deletion
    const { data: linkedInsightsBeforeDelete } = await supabaseAdmin
      .from("insight_sources")
      .select("insight_id")
      .eq("run_id", id)

    // Delete insight_sources for this specific run
    const { error: deleteInsightSourcesError } = await supabaseAdmin
      .from("insight_sources")
      .delete()
      .eq("run_id", id)

    if (deleteInsightSourcesError) {
      console.warn("Warning: Failed to delete some insight_sources:", deleteInsightSourcesError)
    }

    // Delete orphaned insights (insights that had no other source links after removing this run's links)
    if (linkedInsightsBeforeDelete && linkedInsightsBeforeDelete.length > 0) {
      const potentiallyOrphanedInsightIds = Array.from(new Set<string>(linkedInsightsBeforeDelete.map((li: any) => li.insight_id as string)))
      
      // Check which of these insights still have other source links (from other runs or sources)
      const { data: remainingLinks } = await supabaseAdmin
        .from("insight_sources")
        .select("insight_id")
        .in("insight_id", potentiallyOrphanedInsightIds)

      if (remainingLinks) {
        const stillLinkedIds = new Set<string>(remainingLinks.map((li: any) => li.insight_id as string))
        const orphanedInsightIds: string[] = potentiallyOrphanedInsightIds.filter(
          (insightId: string) => !stillLinkedIds.has(insightId)
        )

        if (orphanedInsightIds.length > 0) {
          const { error: deleteOrphansError } = await supabaseAdmin
            .from("insights")
            .delete()
            .in("id", orphanedInsightIds)

          if (deleteOrphansError) {
            console.warn("Warning: Failed to delete some orphaned insights:", deleteOrphansError)
          } else {
            console.log(`Deleted ${orphanedInsightIds.length} orphaned insights`)
          }
        }
      }
    }

    // Delete chunks for this specific run
    const { error: deleteChunksError } = await supabaseAdmin
      .from("chunks")
      .delete()
      .eq("run_id", id)

    if (deleteChunksError) {
      console.warn("Warning: Failed to delete chunks:", deleteChunksError)
    } else {
      console.log(`Deleted chunks for run ${id}`)
    }

    // Check if this was a 'processing' run before deleting
    const wasProcessing = run.status === 'processing'

    // Delete the run record
    const { error: deleteError } = await supabaseAdmin
      .from('source_processing_runs')
      .delete()
      .eq('id', id)

    if (deleteError) {
      throw new Error(`Failed to delete run: ${deleteError.message}`)
    }

    // If we deleted a 'processing' run, check if there are any other processing runs
    // If not, reset the source's processing_status
    if (wasProcessing) {
      const { data: otherProcessingRuns } = await supabaseAdmin
        .from('source_processing_runs')
        .select('id')
        .eq('source_id', run.source_id)
        .eq('status', 'processing')
        .limit(1)

      // If no other processing runs exist, reset the source status
      if (!otherProcessingRuns || otherProcessingRuns.length === 0) {
        const { error: updateSourceError } = await supabaseAdmin
          .from('sources')
          .update({
            processing_status: 'failed', // Mark as failed since processing was interrupted
            processing_error: 'Processing run was deleted before completion'
          })
          .eq('id', run.source_id)

        if (updateSourceError) {
          console.warn("Warning: Failed to update source processing_status after deleting processing run:", updateSourceError)
        }
      }
    }

    return NextResponse.json({
      success: true,
      message: "Processing run deleted successfully along with associated chunks and insights for this run only"
    })
  } catch (error) {
    console.error("Error in POST /api/admin/runs/[id]/delete:", error)
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Unknown error" },
      { status: 500 }
    )
  }
}


