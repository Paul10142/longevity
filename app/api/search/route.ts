import { NextRequest, NextResponse } from "next/server"
import { hybridSearch } from "@/lib/search"

/**
 * Search API endpoint
 * Supports both semantic and keyword search
 * 
 * POST /api/search
 * Body: { query: string, conceptId?: string }
 */
export async function POST(request: NextRequest) {
  try {
    const body = await request.json()
    const { query, conceptId } = body

    if (!query || typeof query !== 'string' || query.trim().length === 0) {
      return NextResponse.json(
        { error: "Query is required and must be a non-empty string" },
        { status: 400 }
      )
    }

    // Perform hybrid search (semantic + keyword)
    const results = await hybridSearch(query.trim(), conceptId, 20) // Limit to 20 for dropdown

    return NextResponse.json({
      success: true,
      results,
      count: results.length,
    })
  } catch (error) {
    console.error("Error in POST /api/search:", error)
    return NextResponse.json(
      { 
        error: error instanceof Error ? error.message : "Unknown error",
        details: error instanceof Error ? error.stack : undefined
      },
      { status: 500 }
    )
  }
}

