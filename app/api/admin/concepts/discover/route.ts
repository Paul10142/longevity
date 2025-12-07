import { NextRequest, NextResponse } from "next/server"
import { discoverConceptsFromSource } from "@/lib/conceptDiscovery"

/**
 * Background job to discover and create concepts from a source
 * Called after source processing completes
 * 
 * POST /api/admin/concepts/discover
 * Body: { sourceId: string }
 */
export async function POST(request: NextRequest) {
  try {
    const body = await request.json()
    const { sourceId } = body

    if (!sourceId || typeof sourceId !== 'string') {
      return NextResponse.json(
        { error: "sourceId is required and must be a string" },
        { status: 400 }
      )
    }

    // Run concept discovery (silent background job with logged progress)
    const result = await discoverConceptsFromSource(sourceId)

    console.log(`[Concept Discovery] Completed for source ${sourceId}:`, result)

    return NextResponse.json({
      success: true,
      message: `Processed ${result.processed} concepts, created ${result.created} new, linked ${result.linked} insights`,
      result,
    })
  } catch (error) {
    console.error("Error in POST /api/admin/concepts/discover:", error)
    return NextResponse.json(
      { 
        error: error instanceof Error ? error.message : "Unknown error",
        details: error instanceof Error ? error.stack : undefined
      },
      { status: 500 }
    )
  }
}

