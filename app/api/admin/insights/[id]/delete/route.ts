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

    // Soft delete: set deleted_at timestamp
    const { error } = await supabaseAdmin
      .from('insights')
      .update({ deleted_at: new Date().toISOString() })
      .eq('id', id)

    if (error) {
      throw new Error(`Failed to delete insight: ${error.message}`)
    }

    return NextResponse.json({
      success: true,
      message: "Insight deleted successfully"
    })
  } catch (error) {
    console.error("Error in POST /api/admin/insights/[id]/delete:", error)
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Unknown error" },
      { status: 500 }
    )
  }
}

